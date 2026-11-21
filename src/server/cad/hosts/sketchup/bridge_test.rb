# Exercises the SketchUp bridge against a small fake of the SketchUp Ruby API.
# Run with: ruby src/server/cad/hosts/sketchup/bridge_test.rb
# The fake covers what the bridge calls; real-host behaviour still needs a
# SketchUp session (see docs/user/cad.md).
ENV['INERTIA_CAD_BRIDGE_TEST'] = '1'
require 'minitest/autorun'
require 'tmpdir'
require 'json'
require 'socket'

MB_YESNO = 4
IDYES = 6
IDNO = 7

module Geom
  class Vector3d
    attr_reader :x, :y, :z

    def initialize(x = 0, y = 0, z = 0)
      @x = x.to_f
      @y = y.to_f
      @z = z.to_f
    end

    def transform(transformation)
      transformation.apply_vector(self)
    end

    def to_a
      [x, y, z]
    end
  end

  class Point3d < Vector3d
    def transform(transformation)
      transformation.apply_point(self)
    end

    def distance(other)
      Math.sqrt(to_a.zip(other.to_a).sum { |a, b| (a - b)**2 })
    end
  end

  # Translation plus uniform scale is enough for these tests.
  class Transformation
    attr_reader :offset, :scale

    def initialize(offset = [0, 0, 0], scale = 1.0)
      @offset = offset.map(&:to_f)
      @scale = scale.to_f
    end

    def self.translation(vector)
      new(vector.to_a)
    end

    def *(other)
      Transformation.new(apply_point(Point3d.new(*other.offset)).to_a, scale * other.scale)
    end

    def inverse
      Transformation.new(offset.map { |v| -v / scale }, 1.0 / scale)
    end

    def apply_point(point)
      Point3d.new(*point.to_a.each_with_index.map { |v, i| v * scale + offset[i] })
    end

    def apply_vector(vector)
      Vector3d.new(*vector.to_a.map { |v| v * scale })
    end

    def to_a
      [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0] + offset + [1]
    end
  end

  class BoundingBox
    attr_reader :min, :max

    def initialize(min = nil, max = nil)
      @min = min
      @max = max
    end

    def empty?
      min.nil?
    end

    def corner(index)
      Point3d.new(index & 1 == 0 ? min.x : max.x, index & 2 == 0 ? min.y : max.y, index & 4 == 0 ? min.z : max.z)
    end
  end
end

module UI
  @answers = []
  @timers = []
  class << self
    attr_accessor :answers, :timers, :messages
  end

  def self.messagebox(message, _type)
    (@messages ||= []) << message
    @answers.shift || IDNO
  end

  def self.start_timer(_seconds, _repeat, &block)
    @timers << block
    @timers.size
  end

  def self.stop_timer(_id); end
end

module Sketchup
  @next_pid = 100
  def self.next_pid
    @next_pid += 1
  end

  class << self
    attr_accessor :active_model
  end

  def self.version
    '26.0.0'
  end

  def self.platform
    :platform_osx
  end

  def self.add_observer(_observer); end

  class ModelObserver; end
  class AppObserver; end

  class Color
    attr_reader :rgb

    def initialize(r, g, b)
      @rgb = [r, g, b]
    end
  end

  class Layer
    attr_reader :name

    def initialize(name)
      @name = name
    end

    def display_name
      name == 'Layer0' ? 'Untagged' : name
    end
  end

  class Material
    attr_accessor :name, :color, :alpha

    def initialize(name)
      @name = name
    end

    def display_name
      name
    end
  end

  class Collection
    include Enumerable

    def initialize(klass, items)
      @klass = klass
      @items = items
    end

    def each(&block)
      @items.each(&block)
    end

    def [](index)
      @items[index]
    end

    def add(name)
      item = @klass.new(name)
      @items << item
      item
    end
  end

  class Drawingelement
    attr_accessor :layer, :material, :parent
    attr_reader :persistent_id
    attr_writer :hidden

    def initialize(model)
      @model = model
      @persistent_id = Sketchup.next_pid
      @layer = model.layers[0]
      @valid = true
      model.registry[@persistent_id] = self
    end

    def hidden?
      @hidden == true
    end

    def bounds
      Geom::BoundingBox.new(Geom::Point3d.new(0, 0, 0), Geom::Point3d.new(1, 1, 1))
    end

    def valid?
      @valid
    end

    def erase!
      @valid = false
      parent_entities = parent.is_a?(Model) ? parent.entities : parent.entities
      parent_entities.delete(self)
    end
  end

  class Face < Drawingelement
    attr_reader :normal, :pushed

    def initialize(model, z_normal)
      super(model)
      @normal = Geom::Vector3d.new(0, 0, z_normal)
    end

    def reverse!
      @normal = Geom::Vector3d.new(0, 0, -@normal.z)
    end

    def pushpull(distance)
      @pushed = distance
    end

    # One square inch in its own space; SketchUp's Face#area scales by a transformation.
    def area(transformation = nil)
      transformation.nil? ? 1.0 : transformation.scale**2
    end

    def bounds
      Geom::BoundingBox.new(Geom::Point3d.new(0, 0, 0), Geom::Point3d.new(1, 1, 0))
    end
  end

  Vertex = Struct.new(:position)

  class Edge < Drawingelement
    attr_reader :start, :end

    # One inch long in its own space.
    def initialize(model)
      super(model)
      @start = Vertex.new(Geom::Point3d.new(0, 0, 0))
      @end = Vertex.new(Geom::Point3d.new(1, 0, 0))
    end

    # Like SketchUp's Edge#length: in the edge's own space, never scaled.
    def length
      1.0
    end
  end
  class Text < Drawingelement; end
  class Dimension < Drawingelement; end
  class Image < Drawingelement; end
  class ConstructionLine < Drawingelement; end
  class ConstructionPoint < Drawingelement; end
  class SectionPlane < Drawingelement; end

  class Entities < Array
    def initialize(model, owner)
      super()
      @model = model
      @owner = owner
    end

    def add_group
      definition = ComponentDefinition.new(@model, 'Group#1')
      group = Group.new(@model, definition)
      group.parent = @owner
      self << group
      group
    end

    def add_face(*_points)
      face = Face.new(@model, -1)
      face.parent = @owner
      self << face
      face
    end
  end

  class ComponentDefinition
    attr_reader :name, :entities, :instances

    def initialize(model, name)
      @name = name
      @entities = Entities.new(model, self)
      @instances = []
    end
  end

  class ComponentInstance < Drawingelement
    attr_accessor :name, :transformation, :locked
    attr_reader :definition

    def initialize(model, definition, offset = [0, 0, 0])
      super(model)
      @definition = definition
      @name = ''
      @transformation = Geom::Transformation.new(offset)
      definition.instances << self
    end

    def locked?
      @locked == true
    end

    def transform!(transformation)
      @transformation = transformation * @transformation
    end

    def bounds
      min = Geom::Point3d.new(0, 0, 0).transform(@transformation)
      max = Geom::Point3d.new(10, 10, 10).transform(@transformation)
      Geom::BoundingBox.new(min, max)
    end
  end

  class Group < ComponentInstance
    def entities
      definition.entities
    end
  end

  class Selection < Array; end

  class View
    def vpwidth
      1600
    end

    def vpheight
      900
    end

    def write_image(options)
      File.binwrite(options[:filename], 'PNG')
      true
    end
  end

  class Model
    attr_accessor :title, :path, :active_path, :operations, :fail_next_step
    attr_reader :entities, :layers, :materials, :selection, :registry

    def initialize
      @registry = {}
      @layers = Collection.new(Layer, [Layer.new('Layer0')])
      @materials = Collection.new(Material, [])
      @entities = Entities.new(self, self)
      @selection = Selection.new
      @title = 'House'
      @path = '/tmp/House.skp'
      @operations = []
    end

    def valid?
      true
    end

    def modified?
      false
    end

    def options
      { 'UnitsOptions' => { 'LengthUnit' => 2 } }
    end

    def add_observer(_observer); end

    def edit_transform
      Geom::Transformation.new
    end

    def find_entity_by_persistent_id(pid)
      @registry[pid]
    end

    def start_operation(name, _disable_ui)
      @operations << [:start, name]
      true
    end

    def commit_operation
      @operations << [:commit]
      true
    end

    def abort_operation
      @operations << [:abort]
      true
    end

    def active_view
      View.new
    end

    def pages
      Struct.new(:selected_page).new(nil)
    end

    def save_copy(path)
      File.binwrite(path, 'SKP')
      true
    end

    def instance(definition, parent_entities, parent, offset = [0, 0, 0], klass = ComponentInstance)
      instance = klass.new(self, definition, offset)
      instance.parent = parent
      parent_entities << instance
      instance
    end
  end
end

require_relative 'inertia_cad_bridge/main'

class BridgeTest < Minitest::Test
  Bridge = Inertia::CadBridge

  def setup
    Bridge.instance_variable_set(:@models, {})
    Bridge.instance_variable_set(:@revisions, {})
    UI.answers = []
    UI.messages = []
    @model = Sketchup::Model.new
    Sketchup.active_model = @model
    @model.layers.add('Walls')
    @room = Sketchup::ComponentDefinition.new(@model, 'Room')
    @chair_definition = Sketchup::ComponentDefinition.new(@model, 'Chair')
    @room_a = @model.instance(@room, @model.entities, @model, [0, 0, 0])
    @room_b = @model.instance(@room, @model.entities, @model, [100, 0, 0])
    @nested_chair = @model.instance(@chair_definition, @room.entities, @room, [1, 1, 0])
    @loose_chair = @model.instance(@chair_definition, @model.entities, @model, [50, 50, 0])
    @loose_chair.name = 'Loose chair'
    @document_id = Bridge.documents({})['documents'].first['documentId']
  end

  def call(method, params = {})
    Bridge.handle_line(JSON.generate('id' => 'r1', 'token' => 'secret', 'method' => method, 'params' => params), 'secret')
  end

  def test_rejects_a_bad_token
    response = Bridge.handle_line(JSON.generate('id' => 'x', 'token' => 'nope', 'method' => 'hello'), 'secret')
    assert_equal false, response['ok']
    assert_equal 'UNAUTHORIZED', response['error']['code']
  end

  def test_rejects_unknown_methods_instead_of_running_code
    response = call('eval_ruby', 'code' => 'exit')
    assert_equal 'UNSUPPORTED_OPERATION', response['error']['code']
  end

  def test_documents_report_units_and_activity
    document = call('documents')['result']['documents'].first
    assert_equal 'House', document['name']
    assert_equal true, document['active']
    assert_equal 'mm', document['displayUnits']
  end

  def test_query_walks_nested_components_and_pages
    result = call('query', 'documentId' => @document_id, 'types' => ['component'], 'limit' => 2)['result']
    assert_equal 5, result['total'], 'two rooms, one chair in each room occurrence, one loose chair'
    assert_equal 2, result['items'].size
    assert_equal '2', result['nextCursor']
    nested = call('query', 'documentId' => @document_id, 'nameContains' => 'chair')['result']['items']
    assert(nested.any? { |row| row['shared'] && row['depth'] == 1 })
    loose = nested.find { |row| row['name'] == 'Loose chair' }
    assert_equal [1270.0, 1270.0, 0.0], loose['boundsMm']['min']
  end

  def test_measures_faces_and_edges_in_world_space_inside_a_scaled_group
    group = @model.entities.add_group
    group.entities.add_face
    edge = Sketchup::Edge.new(@model)
    edge.parent = group.definition
    group.entities << edge
    group.transform!(Geom::Transformation.new([0, 0, 0], 2.0))
    rows = call('query', 'documentId' => @document_id, 'types' => %w[face edge])['result']['items']
    face = rows.find { |row| row['type'] == 'face' }
    line = rows.find { |row| row['type'] == 'edge' }
    assert_equal (4 * 25.4 * 25.4).round(1), face['areaMm2'], 'a square inch scaled 2x is four square inches'
    assert_equal 50.8, line['lengthMm'], 'an inch scaled 2x is two inches'
  end

  def test_query_rejects_unknown_types
    response = call('query', 'documentId' => @document_id, 'types' => ['wall'])
    assert_equal 'INVALID_REQUEST', response['error']['code']
  end

  def test_refuses_to_edit_a_component_shared_by_several_parents
    response = call('preview', 'documentId' => @document_id,
                               'operations' => [{ 'op' => 'skp.set_tag', 'ids' => [@nested_chair.persistent_id.to_s], 'tag' => 'Walls' }])
    assert_equal 'SHARED_DEFINITION', response['error']['code']
  end

  def test_preview_then_approved_apply_is_one_operation
    operations = [{ 'op' => 'skp.set_tag', 'ids' => [@loose_chair.persistent_id.to_s], 'tag' => 'Walls' }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    assert_equal 'Untagged', preview['changes'].first['before']
    assert_equal 'Layer0', @loose_chair.layer.name, 'preview must not change the model'
    UI.answers = [IDYES]
    applied = call('apply', 'documentId' => @document_id, 'operations' => operations,
                            'expectedFingerprints' => preview['fingerprints'], 'approvalMessage' => 'Apply?', 'title' => 'Retag')['result']
    assert_equal 'applied', applied['status']
    assert_equal 'Walls', @loose_chair.layer.name
    assert_equal [[:start, 'Inertia: Retag'], [:commit]], @model.operations
    assert_equal ['Apply?'], UI.messages
  end

  def test_rejected_approval_leaves_the_model_untouched
    operations = [{ 'op' => 'skp.set_hidden', 'ids' => [@loose_chair.persistent_id.to_s], 'hidden' => true }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    UI.answers = [IDNO]
    result = call('apply', 'documentId' => @document_id, 'operations' => operations,
                           'expectedFingerprints' => preview['fingerprints'], 'approvalMessage' => 'Apply?')['result']
    assert_equal 'rejected', result['status']
    refute @loose_chair.hidden?
    assert_empty @model.operations
  end

  def test_a_target_changed_after_preview_is_refused_before_asking
    operations = [{ 'op' => 'skp.rename', 'ids' => [@loose_chair.persistent_id.to_s], 'name' => 'Desk chair' }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    @loose_chair.transform!(Geom::Transformation.new([1, 0, 0]))
    UI.answers = [IDYES]
    response = call('apply', 'documentId' => @document_id, 'operations' => operations,
                             'expectedFingerprints' => preview['fingerprints'], 'approvalMessage' => 'Apply?')
    assert_equal 'TARGET_CHANGED', response['error']['code']
    assert_empty UI.messages
    assert_equal 'Loose chair', @loose_chair.name
  end

  def test_creates_a_tag_and_uses_it_in_the_same_change
    operations = [
      { 'op' => 'skp.create_tag', 'name' => 'Furniture' },
      { 'op' => 'skp.set_tag', 'ids' => [@loose_chair.persistent_id.to_s], 'tag' => 'Furniture' }
    ]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    UI.answers = [IDYES]
    call('apply', 'documentId' => @document_id, 'operations' => operations, 'expectedFingerprints' => preview['fingerprints'])
    assert_equal 'Furniture', @loose_chair.layer.name
  end

  def test_moves_in_millimetres
    operations = [{ 'op' => 'skp.move', 'ids' => [@loose_chair.persistent_id.to_s], 'vectorMm' => [254, 0, 0] }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    UI.answers = [IDYES]
    call('apply', 'documentId' => @document_id, 'operations' => operations, 'expectedFingerprints' => preview['fingerprints'])
    assert_in_delta 60.0, @loose_chair.transformation.offset[0], 1e-9
  end

  def test_adds_a_box_group_with_an_upward_extrusion
    operations = [{ 'op' => 'skp.add_box', 'originMm' => [0, 0, 0], 'sizeMm' => [254, 254, 25.4], 'name' => 'Plinth', 'tag' => 'Walls' }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    UI.answers = [IDYES]
    response = call('apply', 'documentId' => @document_id, 'operations' => operations, 'expectedFingerprints' => preview['fingerprints'])
    assert response['ok'], response.inspect
    result = response['result']
    group = @model.find_entity_by_persistent_id(Integer(result['created'].first['id']))
    assert_equal 'Plinth', group.name
    assert_equal 'Walls', group.layer.name
    face = group.definition.entities.first
    assert_equal 1.0, face.normal.z
    assert_in_delta 1.0, face.pushed, 1e-9
  end

  def test_a_failing_step_aborts_the_whole_operation
    operations = [{ 'op' => 'skp.erase', 'ids' => [@loose_chair.persistent_id.to_s] }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    @loose_chair.define_singleton_method(:erase!) { raise 'host refused' }
    UI.answers = [IDYES]
    response = call('apply', 'documentId' => @document_id, 'operations' => operations, 'expectedFingerprints' => preview['fingerprints'])
    assert_equal 'APPLY_FAILED', response['error']['code']
    assert_equal [:abort], @model.operations.last
  end

  def test_an_edit_inside_a_group_makes_its_erase_preview_stale
    group = @model.entities.add_group
    operations = [{ 'op' => 'skp.erase', 'ids' => [group.persistent_id.to_s] }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    group.entities.add_face([0, 0, 0], [1, 0, 0], [1, 1, 0])
    UI.answers = [IDYES]
    response = call('apply', 'documentId' => @document_id, 'operations' => operations, 'expectedFingerprints' => preview['fingerprints'])
    assert_equal 'TARGET_CHANGED', response['error']['code']
    assert group.valid?
  end

  def test_any_committed_change_makes_an_erase_preview_stale
    operations = [{ 'op' => 'skp.erase', 'ids' => [@loose_chair.persistent_id.to_s] }]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    Bridge.bump(@document_id)
    UI.answers = [IDYES]
    response = call('apply', 'documentId' => @document_id, 'operations' => operations, 'expectedFingerprints' => preview['fingerprints'])
    assert_equal 'TARGET_CHANGED', response['error']['code']
    assert @loose_chair.valid?
  end

  def test_a_later_retag_in_the_same_batch_is_not_skipped
    id = @loose_chair.persistent_id.to_s
    operations = [
      { 'op' => 'skp.set_tag', 'ids' => [id], 'tag' => 'Walls' },
      { 'op' => 'skp.set_tag', 'ids' => [id], 'tag' => 'Untagged' }
    ]
    preview = call('preview', 'documentId' => @document_id, 'operations' => operations)['result']
    assert_equal [%w[Untagged Walls], %w[Walls Untagged]], preview['changes'].map { |change| [change['before'], change['after']] }
    UI.answers = [IDYES]
    call('apply', 'documentId' => @document_id, 'operations' => operations, 'expectedFingerprints' => preview['fingerprints'])
    assert_equal 'Layer0', @loose_chair.layer.name
  end

  def test_save_copy_never_overwrites
    Dir.mktmpdir do |dir|
      path = File.join(dir, 'copy.skp')
      assert_equal path, call('save_copy', 'documentId' => @document_id, 'path' => path)['result']['path']
      assert_equal 'ALREADY_EXISTS', call('save_copy', 'documentId' => @document_id, 'path' => path)['error']['code']
    end
  end

  def test_capture_scales_to_the_requested_box
    result = call('capture', 'documentId' => @document_id, 'maxWidth' => 800, 'maxHeight' => 800)['result']
    assert_equal [800, 450], [result['width'], result['height']]
    assert_equal 'PNG', Base64.decode64(result['pngBase64'])
  end

  def test_the_tcp_transport_answers_one_line_per_request
    Dir.mktmpdir do |home|
      previous = Dir.method(:home)
      Dir.singleton_class.send(:define_method, :home) { home }
      begin
        UI.timers = []
        Bridge.start
        discovery = JSON.parse(File.read(File.join(home, '.inertia-cad', 'hosts', "sketchup-#{Process.pid}.json")))
        socket = TCPSocket.new('127.0.0.1', discovery['port'])
        socket.write("#{JSON.generate('id' => 'a', 'token' => discovery['token'], 'method' => 'hello')}\n")
        response = nil
        20.times do
          UI.timers.each(&:call)
          ready = IO.select([socket], nil, nil, 0.05)
          next unless ready
          response = JSON.parse(socket.gets)
          break
        end
        assert_equal 'sketchup', response['result']['app']
        socket.close
      ensure
        Bridge.stop
        Dir.singleton_class.send(:define_method, :home, previous)
      end
      refute File.exist?(File.join(home, '.inertia-cad', 'hosts', "sketchup-#{Process.pid}.json"))
    end
  end
end
